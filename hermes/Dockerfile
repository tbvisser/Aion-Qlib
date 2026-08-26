# Hermes Agent sidecar for Aion-Qlib (Phase 2).
#
# Thin wrapper around the official image: seeds Aion MCP config on first boot.
# Pin deliberately — bump HERMES_VERSION after smoke-testing a new release.
#
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml build hermes-gateway
#
ARG HERMES_VERSION=v2026.8.19
FROM nousresearch/hermes-agent:${HERMES_VERSION}

USER root

COPY config/ /opt/aion-seed/config/
COPY config/workspace/ /opt/aion-seed/workspace/
COPY scripts/entrypoint.sh /opt/aion/entrypoint.sh
COPY scripts/seed.sh /opt/aion/seed.sh
COPY scripts/healthcheck.sh /opt/aion/healthcheck.sh
RUN chmod +x /opt/aion/entrypoint.sh /opt/aion/seed.sh /opt/aion/healthcheck.sh \
    && chown -R hermes:hermes /opt/aion /opt/aion-seed \
    && rm -rf /opt/data \
    && ln -s /hermes-data /opt/data

# Keep root — official entrypoint-dispatch.sh (s6-overlay) expects it.
ENV HERMES_HOME=/hermes-data

ENTRYPOINT ["/opt/aion/entrypoint.sh"]
CMD ["gateway", "run"]
