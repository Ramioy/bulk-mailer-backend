/** D50 (B8): whether the service can work: its database and its volume. Never throws. */
export interface ReadinessProbe {
  check(): Promise<Readonly<Record<string, boolean>>>;
}
