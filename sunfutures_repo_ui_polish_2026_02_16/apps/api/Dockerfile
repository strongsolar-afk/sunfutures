FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app
COPY pyproject.toml /app/pyproject.toml

RUN pip install --no-cache-dir -U pip \
 && pip install --no-cache-dir .

COPY app /app/app
RUN mkdir -p /app/data/uploads

ENV SUNFUTURES_UPLOAD_DIR=/app/data/uploads
ENV PORT=8080

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
