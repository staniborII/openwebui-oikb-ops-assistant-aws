# Official oikb image plus the sync schedule for this project.
ARG OIKB_IMAGE=ghcr.io/open-webui/oikb:0.6.0
FROM ${OIKB_IMAGE}

COPY .oikb.yaml /config/.oikb.yaml
ENTRYPOINT ["oikb"]
CMD ["daemon", "--config", "/config/.oikb.yaml"]
