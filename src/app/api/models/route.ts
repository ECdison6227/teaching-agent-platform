import { api } from "@/lib/http";
import { listChatModels } from "@/lib/models/provider";
export async function GET() {
  return api(listChatModels);
}
