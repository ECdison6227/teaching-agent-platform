export type ProviderId =
  "school" | "stepfun" | "agnes" | "deepseek" | "openai-compatible";
export type ChatModelOption = {
  id: string;
  provider: ProviderId;
  model: string;
  label: string;
};
