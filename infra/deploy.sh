#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Load .env
ENV_FILE="${PROJECT_ROOT}/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; source "$ENV_FILE"; set +a
fi

STACK_NAME="${STACK_NAME:-cantonese-s2s}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
AWS_REGION="${AWS_REGION:-us-east-1}"

STACK_ONLY=false
DEPLOY_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --stack-only)  STACK_ONLY=true ;;
    --deploy-only) DEPLOY_ONLY=true ;;
    *) echo "Unknown: $arg"; exit 1 ;;
  esac
done

log() { echo "==> $*"; }

get_stack_output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" --region "$AWS_REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

# ============ STEP 1: CloudFormation ============
deploy_stack() {
  log "Deploying CloudFormation stack: $STACK_NAME"

  PARAMS=(
    "ParameterKey=ChimeVoiceConnectorHost,ParameterValue=${CHIME_VOICE_CONNECTOR_HOST:-}"
    "ParameterKey=ChimePhoneNumber,ParameterValue=${CHIME_PHONE_NUMBER:-}"
    "ParameterKey=MiniMaxApiKey,ParameterValue=${MINIMAX_API_KEY:-}"
    "ParameterKey=AwsRegion,ParameterValue=${AWS_REGION}"
    "ParameterKey=ImageTag,ParameterValue=${IMAGE_TAG}"
    "ParameterKey=VoiceId,ParameterValue=${VOICE_ID:-Cantonese_ProfessionalHost（F)}"
    "ParameterKey=S2SEndpoint,ParameterValue=${S2S_ENDPOINT:-ws://localhost:8765/v1/s2s}"
  )

  if aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" &>/dev/null; then
    log "Updating existing stack..."
    aws cloudformation update-stack \
      --stack-name "$STACK_NAME" --region "$AWS_REGION" \
      --template-body "file://${SCRIPT_DIR}/cloudformation.yaml" \
      --capabilities CAPABILITY_NAMED_IAM \
      --parameters "${PARAMS[@]}" 2>&1 || true
    log "Waiting for update..."
    aws cloudformation wait stack-update-complete --stack-name "$STACK_NAME" --region "$AWS_REGION" 2>/dev/null || true
  else
    log "Creating new stack..."
    aws cloudformation create-stack \
      --stack-name "$STACK_NAME" --region "$AWS_REGION" \
      --template-body "file://${SCRIPT_DIR}/cloudformation.yaml" \
      --capabilities CAPABILITY_NAMED_IAM \
      --parameters "${PARAMS[@]}"
    log "Waiting for creation (this may take 5-10 minutes)..."
    aws cloudformation wait stack-create-complete --stack-name "$STACK_NAME" --region "$AWS_REGION"
  fi

  log "Stack outputs:"
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' --output table
}

# ============ STEP 2: Build & Push Docker Images ============
deploy_images() {
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  S2S_REPO=$(get_stack_output "S2SRepositoryUri")
  VS_REPO=$(get_stack_output "VoiceServerRepositoryUri")

  if [ -z "$S2S_REPO" ] || [ -z "$VS_REPO" ]; then
    log "ERROR: Could not get ECR URIs from stack outputs"
    exit 1
  fi

  log "Logging into ECR..."
  aws ecr get-login-password --region "$AWS_REGION" | \
    docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

  # Build & push s2s-service
  log "Building s2s-service..."
  docker build -t "${S2S_REPO}:${IMAGE_TAG}" -f "${PROJECT_ROOT}/s2s-service/Dockerfile" "${PROJECT_ROOT}/s2s-service/"
  log "Pushing s2s-service..."
  docker push "${S2S_REPO}:${IMAGE_TAG}"

  # Build & push voice-server
  log "Building voice-server..."
  docker build -t "${VS_REPO}:${IMAGE_TAG}" -f "${PROJECT_ROOT}/voice-server/Dockerfile" "${PROJECT_ROOT}/voice-server/"
  log "Pushing voice-server..."
  docker push "${VS_REPO}:${IMAGE_TAG}"

  # Update ECS service
  CLUSTER=$(get_stack_output "ECSCluster")
  SERVICE=$(get_stack_output "ECSService")

  if [ -n "$CLUSTER" ] && [ -n "$SERVICE" ]; then
    log "Updating ECS service..."
    aws ecs update-service \
      --cluster "$CLUSTER" --service "$SERVICE" \
      --force-new-deployment --region "$AWS_REGION" > /dev/null
    log "ECS service update initiated. Waiting for stabilization..."
    aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE" --region "$AWS_REGION" 2>/dev/null || true
  fi

  log "Deployment complete!"
}

# ============ Main ============
if $STACK_ONLY; then
  deploy_stack
elif $DEPLOY_ONLY; then
  deploy_images
else
  deploy_stack
  deploy_images
fi

log ""
log "=== Deployment Summary ==="
PUBLIC_IP=$(get_stack_output "PublicIP" 2>/dev/null || echo "pending")
log "Public IP: $PUBLIC_IP"
log "Health: http://${PUBLIC_IP}:3000/health"
log ""
log "IMPORTANT: Configure Chime Voice Connector Origination:"
log "  Host: $PUBLIC_IP"
log "  Port: 5060"
log "  Protocol: UDP"
