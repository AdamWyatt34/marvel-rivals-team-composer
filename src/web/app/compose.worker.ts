import { createWorkerEntry } from "./compose-worker";
import type { WorkerRequest, WorkerResponse } from "./compose-protocol";
import { loadEngine } from "./engine-loader";

const scope = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ): void;
  postMessage(message: WorkerResponse): void;
};
const entry = createWorkerEntry({ engine: loadEngine() });
scope.addEventListener("message", (event) => {
  void entry.onMessage(event.data).then((response) => {
    if (response) scope.postMessage(response);
  });
});
