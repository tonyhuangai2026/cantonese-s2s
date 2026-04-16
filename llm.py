"""Nova 2 Lite streaming via Bedrock Converse API."""
import asyncio
import boto3
from config import AWS_REGION, BEDROCK_MODEL_ID, SYSTEM_PROMPT


class LLMSession:
    def __init__(self):
        self.client = boto3.client("bedrock-runtime", region_name=AWS_REGION)
        self.history = []

    def _call_converse_stream(self, messages):
        response = self.client.converse_stream(
            modelId=BEDROCK_MODEL_ID,
            system=[{"text": SYSTEM_PROMPT}],
            messages=messages,
            inferenceConfig={"maxTokens": 512, "topP": 0.9, "temperature": 0.7},
        )
        chunks = []
        stream = response.get("stream")
        if stream:
            for event in stream:
                if "contentBlockDelta" in event:
                    text = event["contentBlockDelta"].get("delta", {}).get("text", "")
                    if text:
                        chunks.append(text)
        return chunks

    async def generate_stream(self, user_text: str):
        self.history.append({"role": "user", "content": [{"text": user_text}]})
        loop = asyncio.get_event_loop()
        chunks = await loop.run_in_executor(None, self._call_converse_stream, list(self.history))
        full = []
        for text in chunks:
            full.append(text)
            yield text
        self.history.append({"role": "assistant", "content": [{"text": "".join(full)}]})
        if len(self.history) > 20:
            self.history = self.history[-20:]
