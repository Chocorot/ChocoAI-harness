import { automationsApi } from '../../../../../server/api.ts'

export const dynamic = 'force-dynamic'
export const POST = async (req: Request, { params }: { params: Promise<{ id: string }> }) => automationsApi(req, 'POST', (await params).id, true)
