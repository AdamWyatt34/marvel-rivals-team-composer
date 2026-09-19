import { createWorkerState, handleMessage } from "./compose-worker";
import type { WorkerRequest, WorkerResponse } from "./compose-protocol";

const scope = self as unknown as {
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerRequest>) => void): void;
  postMessage(message: WorkerResponse): void;
};
const state = createWorkerState();
scope.addEventListener("message", (event) => {
  const response = handleMessage(state, event.data);
  if (response) scope.postMessage(response);
});
