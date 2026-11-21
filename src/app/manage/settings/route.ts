import { manage } from '../../../server/api.ts'

export const dynamic = 'force-dynamic'
export const PUT = (req: Request) => manage(req, 'settings')
