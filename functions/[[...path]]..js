import worker from "../danmu_api/worker.js";

export const onRequest = async (context) => {
  return worker.fetch(context.request, context.env, context);
};
