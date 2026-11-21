FROM python:3.12-slim
# poppler-utils: pdftotext, so users can attach PDFs (docs/attachments.md); tzdata: HARNESS_TZ for automations (docs/automations.md)
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tzdata && rm -rf /var/lib/apt/lists/* \
 && useradd -m app && mkdir /data /workspace && chown app /data /workspace
WORKDIR /app
COPY *.py ./
COPY web ./web
USER app
ENV HARNESS_DB=/data/harness.db PYTHONUNBUFFERED=1
VOLUME ["/data", "/workspace"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8080/health')"
CMD ["python", "harness.py", "--serve", "8080", "--host", "0.0.0.0", "--auto-approve", "--workspace", "/workspace"]
