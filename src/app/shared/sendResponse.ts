import { Response } from 'express';
import { addTakaFields } from '../utils/money';

type TResponse<T> = {
  statusCode: number;
  success: boolean;
  message?: string;
  meta?: {
    page: number;
    limit: number;
    total: number;
  };
  data?: T;
};

const sendResponse = <T>(res: Response, data: TResponse<T>) => {
  res.status(data.statusCode).json({
    success: data.success,
    message: data.message,
    meta: data.meta,
    // Money lives in the database as integer poisha. Clients have always read
    // taka, so every `<name>Minor` integer goes out with a `<name>` twin.
    data: addTakaFields(data.data),
  });
};

export default sendResponse;
