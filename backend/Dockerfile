FROM python:3.13-alpine@sha256:1e1f6334529d1fb26a2ef619d7cffb30a7c7d7cc1cc7338ebee283a58d1aeaca
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml MANIFEST.in README.md LICENSE ./
COPY backend/requirements.txt backend/requirements.txt
COPY backend/otpigeon backend/otpigeon
RUN pip install --no-cache-dir --upgrade pip && pip install --no-cache-dir . && pip uninstall --yes pip setuptools && adduser -D -u 10001 otpigeon
USER otpigeon
EXPOSE 8000
CMD ["otpigeon", "serve", "--host", "0.0.0.0", "--port", "8000"]
