# Cantonese S2S

Cantonese speech-to-speech service with Nova Sonic v2 compatible WebSocket API.

**Pipeline**: Amazon Transcribe (ASR) + Nova 2 Lite (LLM) + MiniMax TTS

## Deploy via CloudFormation

```bash
aws cloudformation create-stack \
  --stack-name cantonese-s2s \
  --template-body file://cloudformation.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1 \
  --parameters \
    ParameterKey=KeyPairName,ParameterValue=YOUR_KEY \
    ParameterKey=VpcId,ParameterValue=vpc-xxx \
    ParameterKey=SubnetId,ParameterValue=subnet-xxx \
    ParameterKey=MiniMaxApiKey,ParameterValue=YOUR_MINIMAX_KEY
```

## Deploy manually

```bash
git clone https://github.com/tonyhuangai2026/cantonese-s2s.git
cd cantonese-s2s
docker build -t cantonese-s2s .
docker run -d --name cantonese-s2s --network=host \
  -e MINIMAX_API_KEY="your-key" \
  -e AWS_DEFAULT_REGION="us-east-1" \
  cantonese-s2s:latest
```

## API

WebSocket endpoint: `ws://HOST:8765/v1/s2s`

Input/output event format is identical to Amazon Nova Sonic v2 bidirectional streaming protocol.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MINIMAX_API_KEY` | (required) | MiniMax API key |
| `AWS_DEFAULT_REGION` | us-east-1 | AWS region |
| `BEDROCK_MODEL_ID` | us.amazon.nova-2-lite-v1:0 | LLM model |
| `TRANSCRIBE_LANGUAGE` | zh-HK | ASR language |
| `MINIMAX_VOICE_ID` | Cantonese_ProfessionalHost（F) | TTS voice |
| `MINIMAX_TTS_MODEL` | speech-2.8-turbo | TTS model |
| `PORT` | 8765 | Service port |
