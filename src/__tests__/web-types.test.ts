import { expectTypeOf, test } from "vitest";

import type {
  ModuleComponentMountContext,
  ModuleMountContext,
  PlatformModuleMountRequest,
} from "../web/types.js";

test("module mounts prefer authoritative IDs while accepting legacy slugs", () => {
  const target = {} as HTMLElement;
  const authoritative = {
    moduleId: "123e4567-e89b-12d3-a456-426614174000",
    component: "UserProfile",
    target,
  } satisfies PlatformModuleMountRequest;
  const authoritativeWithHint = {
    ...authoritative,
    moduleSlug: "profile-core",
  } satisfies PlatformModuleMountRequest;
  const legacy = {
    moduleSlug: "profile-core",
    component: "UserProfile",
    target,
  } satisfies PlatformModuleMountRequest;

  expectTypeOf(authoritative).toMatchTypeOf<PlatformModuleMountRequest>();
  expectTypeOf(authoritativeWithHint).toMatchTypeOf<PlatformModuleMountRequest>();
  expectTypeOf(legacy).toMatchTypeOf<PlatformModuleMountRequest>();

  // @ts-expect-error A mount must carry an authoritative ID or legacy slug.
  const missingOwner: PlatformModuleMountRequest = {
    component: "UserProfile",
    target,
  };
  expectTypeOf(missingOwner).toMatchTypeOf<PlatformModuleMountRequest>();
});

test("component contexts type manifest props and event payloads", () => {
  interface RoleProps {
    userId: string;
  }
  interface RoleEventPayload {
    role: string;
  }

  const context = {
    apiBase: "/modules/roles",
    fetch: async () => Response.json({}),
    appId: "app-id",
    locale: "en-US",
    navigate: { settings: () => {} },
    component: {
      props: { userId: "user-id" },
      emit: (_type: string, _payload?: RoleEventPayload) => {},
    },
  } satisfies ModuleComponentMountContext<RoleProps, RoleEventPayload>;

  expectTypeOf(context.component.props.userId).toEqualTypeOf<string>();
  context.component.emit("saved", { role: "admin" });
  // @ts-expect-error The component declared a structured event payload.
  context.component.emit("saved", "admin");

  const pageContext: ModuleMountContext = context;
  expectTypeOf(pageContext).toMatchTypeOf<ModuleMountContext>();
});
