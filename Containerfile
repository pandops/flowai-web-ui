FROM docker.io/library/golang:1.26.2-alpine@sha256:f85330846cde1e57ca9ec309382da3b8e6ae3ab943d2739500e08c86393a21b1 AS build

WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
COPY web ./web
RUN CGO_ENABLED=0 GOOS=linux go build -mod=readonly \
    -trimpath \
    -ldflags="-s -w" \
    -o /out/web-ui \
    ./cmd/web-ui

FROM scratch

COPY --from=build /out/web-ui /web-ui
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/web-ui"]
