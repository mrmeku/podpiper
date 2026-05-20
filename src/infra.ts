import infra from "../infra.json";

export const TEMPORAL_GRPC_PORT = infra.temporal.grpcPort;
export const TEMPORAL_UI_PORT = infra.temporal.uiPort;
export const TEMPORAL_GRPC_ADDR = `localhost:${TEMPORAL_GRPC_PORT}`;
export const TEMPORAL_UI_URL = `http://localhost:${TEMPORAL_UI_PORT}`;
