import { ControlPlane } from './control'
import { handleRequest } from './handler'
import type { Env } from './types'

export { ControlPlane }

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env)
  },
} satisfies ExportedHandler<Env>
