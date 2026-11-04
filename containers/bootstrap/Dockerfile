# Image for the one-shot setup task. Runs bootstrap/run.py.
# Alpine has no high-severity findings. The Debian slim tag does, and those packages have no fix yet.
FROM public.ecr.aws/docker/library/python:3.12-alpine

WORKDIR /app
COPY bootstrap/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY bootstrap /app/bootstrap
COPY containers/bootstrap/entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["setup"]
