FROM heroiclabs/nakama-pluginbuilder:3.39.0 AS builder

WORKDIR /backend
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build --trimpath --buildmode=plugin -o /backend/backend.so .

FROM heroiclabs/nakama:3.39.0
COPY --from=builder /backend/backend.so /nakama/data/modules/backend.so
