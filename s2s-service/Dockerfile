FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg gcc python3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir "setuptools<81" -r requirements.txt

COPY *.py .

EXPOSE 8765

ENV PYTHONUNBUFFERED=1

CMD ["python", "server.py"]
