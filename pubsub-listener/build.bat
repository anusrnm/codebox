set GOARCH=amd64
set GOOS=linux
set CGO_ENABLED=0
go build -trimpath -ldflags="-s -w" -o bin/pubsub-listener