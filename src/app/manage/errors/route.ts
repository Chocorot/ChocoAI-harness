import { manage } from '../../../server/api.ts'

export const dynamic = 'force-dynamic'
export const GET = (req: Request) => manage(req, 'errors')
