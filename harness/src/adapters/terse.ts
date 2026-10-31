import type { ActorConfig, ActorsPort } from "../ports/index.js";

/** The part of the generated client this adapter uses. */
export interface TemporaryApiClient {
  get(id: string): { configure(config: ActorConfig): Promise<{ configured: boolean }> };
}

export class TerseActors implements ActorsPort {
  constructor(private readonly client: TemporaryApiClient) {}

  async configure(apiId: string, config: ActorConfig, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.client.get(apiId).configure(config);
  }
}
