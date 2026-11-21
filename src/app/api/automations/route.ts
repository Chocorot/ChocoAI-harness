import { automationsApi } from '../../../server/api.ts'

export const dynamic = 'force-dynamic'
export const GET = (req: Request) => automationsApi(req, 'GET')
export const POST = (req: Request) => automationsApi(req, 'POST')
