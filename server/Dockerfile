FROM golang:1.26-alpine AS build

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -o /stage-utility-server .

FROM alpine:3.23

RUN apk add --no-cache ca-certificates wget

COPY --from=build /stage-utility-server /stage-utility-server

EXPOSE 8080

CMD ["/stage-utility-server"]
