FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
EXPOSE 8080
# --access-log gives the request lines Tares's docker_logs connector tails.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--access-log"]
