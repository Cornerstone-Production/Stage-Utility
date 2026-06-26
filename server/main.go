package main

import (
	"github.com/sirupsen/logrus"

	"github.com/cornerstone-production/stage-utility/server/api"
)

func main() {
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{})

	connectSrv := api.ConnectServer{
		Logger: logger,
		Port:   "8080",
	}
	connectSrv.Serve()
}
