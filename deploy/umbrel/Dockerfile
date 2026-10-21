FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg fonts-dejavu-core fonts-noto-core curl ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY tools/speech-requirements.txt /tmp/speech-requirements.txt
RUN python3 -m venv /opt/speech && /opt/speech/bin/pip install --no-cache-dir -r /tmp/speech-requirements.txt yt-dlp && python3 -m venv /opt/agent && /opt/agent/bin/pip install --no-cache-dir nanobot-ai==0.3.0
COPY server.js package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY lib ./lib
COPY public ./public
COPY tools/*.py ./tools/
COPY tools/check-local.js tools/validate-campaign.js tools/private-state-backup.js deploy/umbrel/migrate-state.js ./tools/
COPY tests ./tests
RUN chmod -R a+rX /app
ENV VS_HOST=0.0.0.0 VS_PORT=34567 VS_ROLE=all VS_JOB_CONCURRENCY=1 VS_SPEECH_PYTHON=/opt/speech/bin/python VS_AGENT_PYTHON=/opt/agent/bin/python VS_SPEECH_MODELS_DIR=/app/data/speech-models HF_HUB_DISABLE_XET=1 PYTHONDONTWRITEBYTECODE=1
ENV PATH=/opt/speech/bin:$PATH
ENV VS_TEST_PYTHON=/opt/speech/bin/python
USER 1000:1000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:34567/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini","-s","--"]
CMD ["node","server.js"]
