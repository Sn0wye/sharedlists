# syntax=docker/dockerfile:1

# cargo-chef caches the dependency build in its own layer, so code-only changes
# recompile just this crate instead of the whole dependency tree.
FROM rust:1-slim-bookworm AS chef
RUN cargo install cargo-chef --locked
WORKDIR /app

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY . .
RUN cargo build --release --locked --bin api

# Distroless: glibc + CA certs only, no shell, runs as non-root.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=builder /app/target/release/api /app/api
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 CMD ["/app/api", "healthcheck"]
ENTRYPOINT ["/app/api"]
