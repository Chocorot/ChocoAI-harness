import { backchannelLogout } from '../../../../../server/backchannel.ts'

export const dynamic = 'force-dynamic'

export const POST = (req: Request) => backchannelLogout(req)
export const GET = POST // answered with 405 by the handler
