package api

import (
	"net/http"
	"time"

	"github.com/sirupsen/logrus"

	stage "github.com/cornerstone-production/stage-utility/server/internal/connecthandlers/gen/stage/v1"
	v1Stage "github.com/cornerstone-production/stage-utility/server/internal/connecthandlers/v1/stage"
)

type ConnectServer struct {
	Logger *logrus.Logger
	Port   string
}

// Serve starts the Connect HTTP server until it exits.
func (c *ConnectServer) Serve() {
	stageSvc := &v1Stage.Service{}

	mux := http.NewServeMux()
	path, handler := stage.NewStageServiceHandler(stageSvc)
	mux.Handle(path, handler)

	httpHandler := LoggingMiddleware(c.Logger)(CorsMiddleware(mux))
	server := http.Server{
		Addr:              ":" + c.Port,
		Handler:           httpHandler,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       10 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
	}

	c.Logger.WithField("port", c.Port).Info("listening")
	if err := server.ListenAndServe(); err != nil {
		c.Logger.WithError(err).Error("listen error")
	}
}
