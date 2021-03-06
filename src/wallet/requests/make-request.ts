export class RequestError {
  public statusCode: number;
  public message: any;

  constructor(message: any, statusCode: number) {
    this.message = message;
    this.statusCode = statusCode;
  }
}

// if body does a post..
export default async function makeRequest<T>(url: string, body?: any): Promise<T | RequestError> {
  let fetchResult;

  try {
    fetchResult = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return new RequestError(err, 0);
  }

  // there is no JSON --
  if (fetchResult.status === 404) {
    return new RequestError('404ph', fetchResult.status);
  }

  let json = await fetchResult.json();

  if (fetchResult.status !== 200) {
    console.log('giving a fetch error');
    return new RequestError(json, fetchResult.status);
  }

  return json as T;
}
