import { describe, expect, test } from 'bun:test';
import { Container, type JsonObject, type Resolver } from '@framework/core';
import type { DataContext } from '@framework/database';
import { type DomainEvent, EVENT_BUS, MemoryEventBus } from '@framework/events';
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
import { baseService, type CrudRepository, DEFAULT_SERVICE_CONTEXT, ownedBy, ResourceService } from '../src';

const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  authorId: text('author_id').notNull(),
});

type Post = typeof posts.$inferSelect;
type PostCreate = { title: string; authorId: string } & JsonObject;

const repository = {
  create: async (data: PostCreate): Promise<Post> => ({ id: 1, ...data }),
} as unknown as CrudRepository<Post, PostCreate>;

const context: DataContext = DEFAULT_SERVICE_CONTEXT as DataContext;

const publishedOn = (bus: MemoryEventBus): DomainEvent[] => {
  const published: DomainEvent[] = [];
  bus.subscribe('posts', async (event) => {
    published.push(event);
  });
  return published;
};

describe('ownedBy typing', () => {
  test('keeps the field name it was given', () => {
    const ownership = ownedBy('authorId');
    const field: 'authorId' = ownership.field;

    expect(field).toBe('authorId');
  });

  test('accepts a real column and refuses any other name', () => {
    expect(baseService(posts, undefined, { ownership: ownedBy('authorId') })).toBeFunction();
    expect(
      baseService(posts, context, {
        repository,
        // @ts-expect-error not a column of posts
        ownership: ownedBy('ownerId'),
      }),
    ).toBeDefined();
  });

  test('checks the entity on a hand-written service too', () => {
    expect(new ResourceService(repository, context, { ownership: ownedBy('authorId') })).toBeDefined();
    expect(
      new ResourceService(repository, context, {
        // @ts-expect-error not a property of Post
        ownership: ownedBy('ownerId'),
      }),
    ).toBeDefined();
  });
});

describe('container option', () => {
  test('takes a real Container without a cast and finds its event bus', async () => {
    const bus = new MemoryEventBus();
    const published = publishedOn(bus);
    const container = new Container();
    container.bind(EVENT_BUS, () => bus);

    const service = baseService(posts, context, { repository, container });
    await service.create({ title: 'From the container', authorId: 'author-1' });

    expect(published.map((event) => event.type)).toEqual(['posts.created']);
  });

  test('refuses an object that is not a resolver', () => {
    const notAResolver = { has: (name: string) => name === 'events.bus' };

    expect(
      baseService(posts, context, {
        repository,
        // @ts-expect-error has no resolve, and its has takes a string
        container: notAResolver,
      }),
    ).toBeDefined();
  });

  test('falls back to a resolver on the context', async () => {
    const bus = new MemoryEventBus();
    const published = publishedOn(bus);
    const scope: Resolver = {
      has: (token) => token === EVENT_BUS,
      resolve: () => bus as never,
    };
    const scoped = { ...context, scope } as DataContext;

    await baseService(posts, scoped, { repository }).create({ title: 'From the scope', authorId: 'author-1' });

    expect(published.map((event) => event.type)).toEqual(['posts.created']);
  });

  test('ignores a context value that is not a resolver', async () => {
    const scoped = { ...context, scope: { has: () => true } } as DataContext;

    const post = await baseService(posts, scoped, { repository }).create({ title: 'No bus', authorId: 'author-1' });

    expect(post.id).toBe(1);
  });
});
