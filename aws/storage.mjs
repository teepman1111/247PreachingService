import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand,
} from '@aws-sdk/client-s3';
import { DeleteItemCommand, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';

function info(result) {
  const metadata = result.Metadata ?? {};
  return {
    etag: result.ETag?.replace(/^"|"$/g, ''),
    httpEtag: result.ETag,
    size: result.ContentLength ?? 0,
    httpMetadata: { contentType: result.ContentType },
    customMetadata: Object.fromEntries(Object.entries(metadata).map(([name, value]) => [
      name, metadata.encoding === 'base64-v1' && name !== 'encoding'
        ? Buffer.from(value, 'base64').toString('utf8') : value,
    ]).filter(([name]) => name !== 'encoding')),
  };
}

export function s3Bucket(client, bucket) {
  const send = (Command, input) => client.send(new Command({ Bucket: bucket, ...input }));
  async function read(Command, key) {
    try {
      return await send(Command, { Key: key });
    } catch (error) {
      if (error.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }

  return {
    async get(key) {
      const result = await read(GetObjectCommand, key);
      if (!result) return null;
      const body = result.Body.transformToWebStream();
      return {
        ...info(result),
        body,
        json: () => new Response(body).json(),
        arrayBuffer: () => new Response(body).arrayBuffer(),
      };
    },
    async head(key) {
      const result = await read(HeadObjectCommand, key);
      return result && info(result);
    },
    async put(key, body, options = {}) {
      try {
        const result = await send(PutObjectCommand, {
          Key: key, Body: body,
          ContentType: options.httpMetadata?.contentType,
          Metadata: options.customMetadata && {
            encoding: 'base64-v1',
            ...Object.fromEntries(Object.entries(options.customMetadata).map(([name, value]) =>
              [name, Buffer.from(value, 'utf8').toString('base64')])),
          },
          IfMatch: options.onlyIf?.etagMatches ? '"' + options.onlyIf.etagMatches + '"' : undefined,
          IfNoneMatch: options.onlyIf?.etagDoesNotMatch,
        });
        return info(result);
      } catch (error) {
        if (options.onlyIf && [409, 412].includes(error.$metadata?.httpStatusCode)) return null;
        throw error;
      }
    },
    async list({ prefix, cursor } = {}) {
      const result = await send(ListObjectsV2Command, { Prefix: prefix, ContinuationToken: cursor });
      return {
        objects: (result.Contents ?? []).map(item => ({ key: item.Key, uploaded: item.LastModified })),
        truncated: result.IsTruncated, cursor: result.NextContinuationToken,
      };
    },
    delete: key => send(DeleteObjectCommand, { Key: key }),
  };
}

export function sessionStore(client, table) {
  const key = id => ({ id: { S: id } });
  return {
    async get(id) {
      const { Item } = await client.send(new GetItemCommand({ TableName: table, Key: key(id), ConsistentRead: true }));
      return Item ? { ...JSON.parse(Item.identity.S), expires: Number(Item.expires.N) } : null;
    },
    async create(id, { expires, ...identity }) {
      await client.send(new PutItemCommand({
        TableName: table,
        Item: { ...key(id), identity: { S: JSON.stringify(identity) }, expires: { N: String(expires) } },
        ConditionExpression: 'attribute_not_exists(id)',
      }));
    },
    async remove(id) {
      await client.send(new DeleteItemCommand({ TableName: table, Key: key(id) }));
    },
  };
}
