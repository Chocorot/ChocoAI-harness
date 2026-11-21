import { automationsApi } from '../../../../server/api.ts'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }
export const PATCH = async (req: Request, { params }: Ctx) => automationsApi(req, 'PATCH', (await params).id)
export const DELETE = async (req: Request, { params }: Ctx) => automationsApi(req, 'DELETE', (await params).id)
