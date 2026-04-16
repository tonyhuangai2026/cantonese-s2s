/**
 * RTP port pool manager.
 * Allocates and releases UDP ports for RTP sessions from a configured range.
 */

export class PortPool {
  private available: Set<number>;
  private inUse: Set<number>;

  constructor(basePort: number, count: number) {
    this.available = new Set();
    this.inUse = new Set();
    // Use even ports only (RTP convention: even for RTP, odd for RTCP)
    for (let p = basePort; p < basePort + count; p += 2) {
      this.available.add(p);
    }
  }

  /**
   * Allocate a port from the pool. Returns undefined if exhausted.
   */
  allocate(): number | undefined {
    const port = this.available.values().next().value;
    if (port === undefined) return undefined;
    this.available.delete(port);
    this.inUse.add(port);
    return port;
  }

  /**
   * Release a port back to the pool.
   */
  release(port: number): void {
    if (this.inUse.has(port)) {
      this.inUse.delete(port);
      this.available.add(port);
    }
  }

  get activeCount(): number {
    return this.inUse.size;
  }

  get availableCount(): number {
    return this.available.size;
  }
}
