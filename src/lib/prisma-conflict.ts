import { Prisma } from "@prisma/client";

/** 새 unique 키 생성 경쟁·교착으로 롤백된 DB 쓰기만 다시 시도한다. */
export async function retryPrismaConflict<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await write(); }
    catch (error) {
      if (attempt >= 2 || !(error instanceof Prisma.PrismaClientKnownRequestError) || !["P2002", "P2034"].includes(error.code)) throw error;
    }
  }
}
