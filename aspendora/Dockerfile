# Aspendora MeshCentral image: the stock upstream image (BASE_IMAGE) with this fork's changed files on top.
# Why an overlay and not a source build: the published image also has generated files that aren't in git
# (translations, minified views) and an npm-rewritten package.json. The overlay keeps those exactly as upstream ships them.
# Build with aspendora/build.sh, not by hand. It checks that every file changed since BASE_VERSION is in OVERLAY.
# BASE_IMAGE is pinned by digest (aspendora/BASE_IMAGE); BASE_REF is the upstream commit that image was built from
# (its org.opencontainers.image.revision label). build.sh passes both.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG GIT_COMMIT=unknown
COPY overlay/ /opt/meshcentral/meshcentral/
RUN cd /opt/meshcentral/meshcentral && for f in $(cd /opt/meshcentral/meshcentral && ls *.js); do node --check "$f" || exit 1; done
LABEL com.aspendora.source="https://github.com/lacymooretx/MeshCentral" com.aspendora.commit="${GIT_COMMIT}"
