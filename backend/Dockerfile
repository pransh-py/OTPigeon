FROM python:3.13.12-slim-bookworm
WORKDIR /app
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home otpigeon
COPY backend/app ./app
COPY examples ./examples
USER otpigeon
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
