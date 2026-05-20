export interface MemoryScopeRef {
  scope_id: string
  label: string
  writable: boolean
}

export async function listMemoryScopes(): Promise<MemoryScopeRef[]> {
  return [
    {
      scope_id: 'noetica-session-local',
      label: 'Noetica session-local scope',
      writable: false
    }
  ]
}
