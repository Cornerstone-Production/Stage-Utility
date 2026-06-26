package v1Stage

import (
	"context"

	"connectrpc.com/connect"

	stage "github.com/cornerstone-production/stage-utility/server/internal/connecthandlers/gen/stage/v1"
)

// Hello implements stage.v1.StageService.Hello.
func (s *Service) Hello(
	_ context.Context,
	_ *connect.Request[stage.HelloRequest],
) (*connect.Response[stage.HelloResponse], error) {
	return connect.NewResponse(&stage.HelloResponse{}), nil
}
