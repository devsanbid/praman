FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --home /nonexistent --shell /usr/sbin/nologin chaincode \
    && mkdir -p /tmp && chown chaincode /tmp
USER chaincode
COPY bin/certregistry /usr/local/bin/certregistry
EXPOSE 9999
ENTRYPOINT ["/usr/local/bin/certregistry"]
