# NestJS Backend Architecture & Agent Guidelines

## 1. Purpose

This document defines the architecture, folder structure, naming conventions, coding standards, and development rules that must be followed when working on this NestJS backend.

The primary goals are:

* Keep the codebase modular and scalable.
* Follow NestJS best practices.
* Maintain clear separation of responsibilities.
* Make business logic easy to test and maintain.
* Prevent unnecessary coupling between modules.
* Keep configuration and constants centralized.
* Ensure new features follow the existing architecture instead of introducing ad-hoc structures.

> **Important:** Agents must follow this architecture for all new code unless an existing implementation explicitly requires a different pattern.

---

# 2. High-Level Architecture

The backend follows a **modular architecture** based on NestJS.

```text
src/
├── modules/
│   ├── auth/
│   ├── users/
│   ├── roles/
│   ├── notifications/
│   └── ...
│
├── common/
│   ├── decorators/
│   ├── guards/
│   ├── interceptors/
│   ├── middleware/
│   ├── pipes/
│   ├── filters/
│   ├── exceptions/
│   ├── strategies/
│   ├── utils/
│   └── types/
│
├── config/
│   ├── app.config.ts
│   ├── database.config.ts
│   ├── auth.config.ts
│   └── index.ts
│
├── constants/
│   ├── app.constant.ts
│   ├── auth.constant.ts
│   └── index.ts
│
├── database/
│   ├── migrations/
│   ├── seeders/
│   └── database.module.ts
│
├── app.module.ts
└── main.ts
```

---

# 3. `src` Directory

All application source code must live inside `src`.

```text
src/
```

The `src` directory should not contain random files or feature-specific code directly.

Feature-specific functionality belongs inside:

```text
src/modules/
```

Cross-cutting functionality belongs inside:

```text
src/common/
```

Application configuration belongs inside:

```text
src/config/
```

Global/static constants belong inside:

```text
src/constants/
```

---

# 4. Modules

All business/domain modules must be placed inside:

```text
src/modules/
```

Example:

```text
src/modules/
├── auth/
├── users/
├── schools/
├── students/
├── teachers/
├── attendance/
├── notifications/
└── payments/
```

Each module should be **self-contained**.

Example:

```text
src/modules/users/
├── dto/
│   ├── create-user.dto.ts
│   └── update-user.dto.ts
│
├── entities/
│   └── user.entity.ts
│
├── users.controller.ts
├── users.service.ts
├── users.module.ts
├── users.repository.ts
├── users.constant.ts
├── users.types.ts
└── index.ts
```

## Module Responsibilities

### Controller

Responsible for:

* HTTP endpoints.
* Request parameters.
* Request body/query extraction.
* Validation through DTOs.
* Calling services.
* Returning responses.

Controllers should remain thin.

```typescript
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get(':id')
  getUser(@Param('id') id: string) {
    return this.usersService.getUser(id);
  }
}
```

Do **not** put business logic inside controllers.

---

### Service

Services contain business logic.

```typescript
@Injectable()
export class UsersService {
  async getUser(id: string) {
    // Business logic
  }
}
```

Services should:

* Handle business rules.
* Coordinate repositories.
* Call external services when required.
* Transform data when appropriate.

Services should not contain HTTP-specific logic unless there is a strong reason.

---

### Repository

Repositories are responsible for database access.

Example:

```text
users/
├── users.repository.ts
```

```typescript
@Injectable()
export class UsersRepository {
  async findById(id: string) {
    // Database query
  }

  async create(data: CreateUserData) {
    // Database query
  }
}
```

Do not put complex database queries directly inside controllers.

Prefer:

```text
Controller
    ↓
Service
    ↓
Repository
    ↓
Database
```

---

# 5. Module File Structure

For a standard module, prefer:

```text
module-name/
├── dto/
├── entities/
├── repositories/
├── module-name.controller.ts
├── module-name.service.ts
├── module-name.module.ts
├── module-name.repository.ts
├── module-name.constant.ts
├── module-name.types.ts
└── index.ts
```

Only create directories when they are actually required.

Do not create empty folders just to follow the structure.

---

# 6. File Naming Convention

Use the following naming convention:

```text
<feature>.<purpose>.ts
```

Examples:

```text
user.controller.ts
user.service.ts
user.module.ts
user.repository.ts
user.dto.ts
user.constant.ts
user.types.ts
auth.guard.ts
auth.decorator.ts
auth.interceptor.ts
```

For pluralized module names:

```text
users.controller.ts
users.service.ts
users.module.ts
users.repository.ts
```

Follow the naming convention already established by the project.

---

# 7. DTOs

Request validation DTOs belong inside the module:

```text
modules/users/dto/
```

Example:

```text
users/
└── dto/
    ├── create-user.dto.ts
    ├── update-user.dto.ts
    └── list-users.dto.ts
```

Use NestJS validation decorators where appropriate.

```typescript
export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;
}
```

DTOs should represent external request contracts.

Do not use DTOs as database entities.

---

# 8. Entities / Database Models

Database-specific models/entities belong to the relevant module.

Example:

```text
users/
└── entities/
    └── user.entity.ts
```

If the project uses Prisma, Drizzle, TypeORM, or another ORM, follow that ORM's established pattern.

Do not duplicate database schemas unnecessarily.

---

# 9. Types

Module-specific TypeScript types should be placed inside:

```text
<module>/<module>.types.ts
```

Example:

```text
users/users.types.ts
```

Use this file for:

* Interfaces.
* Type aliases.
* Internal service types.
* Complex domain types.

Example:

```typescript
export interface UserFilter {
  search?: string;
  status?: UserStatus;
}
```

Do not create a type file for every small type.

---

# 10. Constants

Constants must **never be scattered throughout the codebase**.

There are two primary locations for constants.

## Module-specific constants

Place them inside the relevant module:

```text
modules/users/users.constant.ts
```

Example:

```typescript
export const USER_CONSTANTS = {
  MAX_LOGIN_ATTEMPTS: 5,
  DEFAULT_PAGE_SIZE: 20,
};
```

## Global constants

Place them inside:

```text
src/constants/
```

Example:

```text
src/constants/
├── app.constant.ts
├── pagination.constant.ts
├── response.constant.ts
└── index.ts
```

### Rule

If a constant is only relevant to one module:

```text
module-name.constant.ts
```

If it is shared across multiple modules:

```text
src/constants/
```

---

# 11. Configuration

Environment variables and application configuration must be handled through:

```text
src/config/
```

Example:

```text
src/config/
├── app.config.ts
├── database.config.ts
├── auth.config.ts
├── mail.config.ts
└── index.ts
```

Do not access `process.env` throughout the application.

Avoid:

```typescript
const port = process.env.PORT;
```

inside random services/controllers.

Prefer centralized configuration:

```typescript
@Injectable()
export class SomeService {
  constructor(private readonly configService: ConfigService) {}

  getValue() {
    return this.configService.get<string>('app.someValue');
  }
}
```

Configuration should be loaded and validated centrally.

---

# 12. Environment Variables

Environment-specific values belong in environment variables.

Examples:

```env
NODE_ENV=development
PORT=3000
DATABASE_URL=
JWT_SECRET=
REDIS_URL=
MAIL_HOST=
MAIL_PORT=
```

Never hardcode:

* API keys.
* Passwords.
* JWT secrets.
* Database credentials.
* Third-party credentials.
* Production URLs when they are environment-specific.
* Encryption keys.

Do not commit `.env` files containing secrets.

Use:

```text
.env
.env.development
.env.production
```

according to the project's environment strategy.

---

# 13. Common Directory

The `common` directory contains functionality that is shared across multiple modules.

```text
src/common/
├── decorators/
├── guards/
├── interceptors/
├── middleware/
├── pipes/
├── filters/
├── exceptions/
├── strategies/
├── utils/
└── types/
```

Do not put module-specific business logic inside `common`.

---

# 14. Decorators

Custom reusable decorators belong inside:

```text
src/common/decorators/
```

Examples:

```text
current-user.decorator.ts
public.decorator.ts
roles.decorator.ts
```

Example:

```typescript
export const CurrentUser = createParamDecorator(
  (_, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest();

    return request.user;
  },
);
```

If a decorator is only useful for one module, keep it inside that module instead of moving it to `common`.

---

# 15. Guards

Global/reusable guards belong inside:

```text
src/common/guards/
```

Examples:

```text
jwt-auth.guard.ts
roles.guard.ts
```

Module-specific guards should remain inside the relevant module.

Example:

```text
modules/admin/
└── guards/
    └── admin-permission.guard.ts
```

---

# 16. Middleware

Reusable middleware belongs inside:

```text
src/common/middleware/
```

Examples:

```text
request-logger.middleware.ts
request-id.middleware.ts
```

Middleware should be used for concerns that operate at the HTTP request/response level.

Do not use middleware for business logic.

---

# 17. Interceptors

Reusable interceptors belong inside:

```text
src/common/interceptors/
```

Examples:

```text
logging.interceptor.ts
transform.interceptor.ts
timeout.interceptor.ts
```

Use interceptors for cross-cutting request/response concerns.

---

# 18. Pipes

Reusable pipes belong inside:

```text
src/common/pipes/
```

Examples:

```text
parse-object-id.pipe.ts
trim.pipe.ts
```

Validation that is specific to one DTO should generally stay in the DTO rather than creating a custom pipe.

---

# 19. Exception Filters

Global/reusable exception filters belong inside:

```text
src/common/filters/
```

Example:

```text
http-exception.filter.ts
```

Do not duplicate error-handling logic across controllers.

---

# 20. Exceptions

Custom reusable exceptions belong inside:

```text
src/common/exceptions/
```

Example:

```text
business.exception.ts
resource-not-found.exception.ts
```

Use NestJS's built-in exceptions whenever they are sufficient:

```typescript
throw new NotFoundException('User not found');
```

Create custom exceptions only when they provide meaningful domain behavior.

---

# 21. Utilities

Reusable generic helper functions belong inside:

```text
src/common/utils/
```

Examples:

```text
date.util.ts
pagination.util.ts
string.util.ts
```

A utility should be:

* Generic.
* Stateless where possible.
* Reusable.
* Independent from business/domain logic.

Do not use `utils` as a dumping ground.

Bad:

```text
utils/
├── create-user.ts
├── process-payment.ts
└── calculate-school-fee.ts
```

These belong to their respective modules/services.

---

# 22. Database

Database infrastructure can live inside:

```text
src/database/
```

Example:

```text
src/database/
├── migrations/
├── seeders/
├── database.module.ts
└── database.service.ts
```

Database-specific business queries should still belong to their respective module repositories.

---

# 23. Dependency Flow

The preferred dependency flow is:

```text
Controller
    ↓
Service
    ↓
Repository
    ↓
Database
```

Cross-cutting concerns:

```text
Middleware
    ↓
Guards
    ↓
Interceptors
    ↓
Pipes
    ↓
Controller
```

Do not bypass layers without a valid architectural reason.

For example, avoid:

```text
Controller → Database
```

or:

```text
Controller → External API
```

when that logic belongs in a service.

---

# 24. Module Dependency Rules

Modules should expose only what other modules actually need.

Example:

```typescript
@Module({
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

Another module can then consume the service through dependency injection.

Avoid importing internal implementation files directly:

```typescript
// Avoid
import { UserRepository } from '../users/internal/user.repository';
```

Prefer the module's public API.

---

# 25. Avoid Circular Dependencies

Avoid:

```text
UsersModule → SchoolsModule → UsersModule
```

If circular dependency appears, reconsider the architecture.

Possible solutions:

* Extract shared logic into a dedicated module.
* Move common functionality into `common`.
* Introduce an abstraction/interface.
* Reconsider module ownership.

Do not immediately use `forwardRef()` as the default solution.

Use `forwardRef()` only when the circular dependency is intentional and unavoidable.

---

# 26. Business Logic Rules

Business logic must live in services/domain-oriented classes.

Bad:

```typescript
@Post()
async create(@Body() dto: CreateUserDto) {
  if (...) {
    ...
  }

  if (...) {
    ...
  }

  await this.database.user.create(...);
}
```

Prefer:

```typescript
@Post()
async create(@Body() dto: CreateUserDto) {
  return this.usersService.createUser(dto);
}
```

And:

```typescript
async createUser(dto: CreateUserDto) {
  // Business rules
  // Validation
  // Repository calls
}
```

Controllers should primarily orchestrate HTTP concerns.

---

# 27. API Response Handling

Use a consistent response structure across the application if the project requires standardized responses.

For example:

```typescript
{
  success: true,
  data: {},
  message: "User fetched successfully"
}
```

The exact response structure should be defined centrally rather than being manually recreated in every controller.

If response transformation is required globally, consider an interceptor.

---

# 28. Pagination

Pagination logic should be standardized.

Shared pagination constants should live in:

```text
src/constants/pagination.constant.ts
```

Reusable pagination utilities should live in:

```text
src/common/utils/pagination.util.ts
```

Module-specific filtering logic should remain inside the module/service/repository.

---

# 29. Logging

Use NestJS's logger or the project's centralized logging solution.

Avoid random:

```typescript
console.log(...)
```

in production code.

If structured logging is implemented, keep it centralized and reusable.

Example:

```text
src/common/
└── logger/
```

---

# 30. Validation

Use NestJS's `ValidationPipe`.

Recommended global configuration:

```typescript
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
);
```

Do not manually validate every request inside controllers when DTO validation can handle it.

---

# 31. Authentication & Authorization

Authentication-related reusable infrastructure should generally be organized as:

```text
src/modules/auth/
├── guards/
├── strategies/
├── decorators/
├── dto/
├── auth.controller.ts
├── auth.service.ts
└── auth.module.ts
```

Global reusable guards/decorators can live in:

```text
src/common/
```

Authorization rules should remain close to the domain they protect.

---

# 32. External Services

External integrations should be isolated behind services.

Examples:

```text
src/modules/notifications/
├── providers/
│   ├── email.provider.ts
│   └── sms.provider.ts
```

or:

```text
src/common/integrations/
```

depending on whether the integration is domain-specific or globally reusable.

Do not scatter third-party API calls throughout the application.

Bad:

```typescript
// Controller
await axios.post('https://third-party-api.com/...');
```

Prefer:

```text
Controller
    ↓
Service
    ↓
Provider / Integration
    ↓
External API
```

---

# 33. Cron Jobs / Scheduled Jobs

Cron jobs must be isolated from normal request handling.

Example:

```text
src/modules/notifications/
├── jobs/
│   └── notification.job.ts
```

Configuration such as:

```env
CRON_ENABLED=true
CRON_TIME=08:00
```

must be managed through configuration.

Do not hardcode environment-specific schedules inside services.

For example, avoid:

```typescript
@Cron('0 8 * * *')
```

when the schedule is supposed to be configurable.

Prefer centralized configuration or a constant where appropriate.

---

# 34. Feature Flags

Feature flags should not be scattered across the application.

Prefer:

```text
src/config/
└── feature.config.ts
```

or module-specific constants/configuration.

Example:

```typescript
if (configService.get<boolean>('feature.enableNewFlow')) {
  ...
}
```

---

# 35. API Versioning

If API versioning is required, use NestJS's built-in versioning approach.

Example:

```text
/api/v1/users
/api/v2/users
```

Do not duplicate entire modules unnecessarily.

Only version endpoints where the contract actually differs.

---

# 36. Index Files

Use `index.ts` files carefully.

Good:

```text
modules/users/index.ts
```

for exposing a module's public exports.

Avoid deeply nested barrel exports that make dependency tracing difficult.

Do not create `index.ts` files everywhere without a purpose.

---

# 37. Import Rules

Prefer path aliases where configured.

Example:

```typescript
import { UsersService } from '@/modules/users/users.service';
```

instead of:

```typescript
import { UsersService } from '../../../../modules/users/users.service';
```

Avoid unnecessarily long relative imports.

---

# 38. Environment-Specific Logic

Do not write:

```typescript
if (process.env.NODE_ENV === 'production') {
  ...
}
```

throughout the application.

Environment-specific configuration should preferably be handled through:

```text
src/config/
```

The business logic should consume configuration rather than directly reading environment variables.

---

# 39. Secrets

Never hardcode secrets.

Never commit:

```text
JWT_SECRET
DATABASE_PASSWORD
AWS_SECRET_ACCESS_KEY
API_KEY
PRIVATE_KEY
```

into source code.

Never put secrets in:

* Constants.
* DTOs.
* Controllers.
* Services.
* Repository files.

Use environment variables or a secret manager.

---

# 40. Comments

Write comments only when they explain **why**, not obvious **what**.

Bad:

```typescript
// Get user
const user = await this.usersService.getUser(id);
```

Good:

```typescript
// We intentionally bypass the cache here because this endpoint
// is used immediately after a profile update.
```

Avoid excessive comments.

Code should be self-explanatory wherever possible.

---

# 41. Error Handling

Do not silently swallow errors.

Bad:

```typescript
try {
  await this.service.process();
} catch (error) {}
```

If an error is intentionally handled:

```typescript
try {
  await this.service.process();
} catch (error) {
  this.logger.error('Failed to process request', error);
  throw new InternalServerErrorException();
}
```

Use meaningful NestJS exceptions where appropriate.

---

# 42. Async Code

Prefer `async/await`.

Avoid unnecessary promise chains.

Good:

```typescript
const user = await this.usersRepository.findById(id);
```

Avoid:

```typescript
return this.usersRepository
  .findById(id)
  .then(...)
  .catch(...);
```

unless there is a specific reason.

---

# 43. Database Query Rules

Do not retrieve unnecessary data.

Avoid:

```typescript
findMany();
```

when only a few fields are required.

Prefer selecting only required fields where supported by the ORM.

Database queries should also avoid:

* N+1 queries.
* Unnecessary repeated queries.
* Loading huge datasets into memory.
* Missing pagination for potentially large datasets.

---

# 44. Transactions

Use database transactions when multiple operations must succeed or fail together.

Example:

```typescript
await this.database.transaction(async (tx) => {
  await tx.user.create(...);
  await tx.profile.create(...);
});
```

Do not use transactions unnecessarily for independent operations.

---

# 45. Testing

Tests should be colocated with the relevant module when possible.

Example:

```text
users/
├── users.service.ts
├── users.service.spec.ts
├── users.controller.ts
└── users.controller.spec.ts
```

Business-critical services should have unit tests.

Integration/e2e tests should cover important API flows.

---

# 46. Security Rules

Always consider:

* Input validation.
* Authentication.
* Authorization.
* Rate limiting.
* SQL/NoSQL injection.
* Sensitive data exposure.
* Secure headers.
* CORS.
* Password hashing.
* Token expiration.
* Request size limits.
* File upload validation.

Never trust client-provided data.

---

# 47. File Uploads

File upload logic should not be placed directly inside controllers.

Prefer:

```text
Controller
    ↓
File Service
    ↓
Storage Provider
```

For example:

```text
modules/files/
├── providers/
│   ├── s3.provider.ts
│   └── local.provider.ts
├── files.controller.ts
├── files.service.ts
└── files.module.ts
```

---

# 48. Dependency Injection

Use NestJS dependency injection.

Prefer:

```typescript
constructor(
  private readonly usersService: UsersService,
) {}
```

Avoid manually instantiating services:

```typescript
const service = new UsersService();
```

unless there is a very specific reason.

---

# 49. Global vs Module-Specific Code

Use this decision rule:

### Put code inside `common/` when:

* Multiple modules use it.
* It has no specific business/domain ownership.
* It represents infrastructure/cross-cutting behavior.

### Put code inside `modules/<module>/` when:

* It belongs to a specific business domain.
* It contains business rules.
* It is only used by that module.

### Put code inside `config/` when:

* It represents application configuration.
* It reads/transforms environment variables.
* It controls environment-specific behavior.

### Put code inside `constants/` when:

* It is a static value shared across the application.
* It is not environment-specific.

---

# 50. Constants vs Configuration

This distinction is important.

### Constant

A value that does not change between environments.

```typescript
export const PAGINATION_CONSTANTS = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
};
```

### Configuration

A value that can change based on environment/deployment.

```env
DATABASE_URL=
PORT=3000
JWT_SECRET=
REDIS_URL=
CRON_ENABLED=true
```

Do not put environment-dependent values inside constants.

---

# 51. Avoid Magic Numbers and Strings

Bad:

```typescript
if (attempts > 5) {
  ...
}
```

Prefer:

```typescript
if (attempts > USER_CONSTANTS.MAX_LOGIN_ATTEMPTS) {
  ...
}
```

Bad:

```typescript
setTimeout(callback, 300000);
```

Prefer:

```typescript
setTimeout(callback, TIME_CONSTANTS.FIVE_MINUTES);
```

However, if the value is environment-dependent, use configuration instead.

---

# 52. Agent Rules for Creating New Files

Before creating a file, determine:

1. Which module owns this functionality?
2. Is this business logic or cross-cutting infrastructure?
3. Is the value a constant or configuration?
4. Is the code reusable across modules?
5. Does an existing utility/service already solve the problem?
6. Can the functionality be added to an existing file instead of creating another file?

Do not create duplicate implementations.

---

# 53. Agent Rules for New Features

When implementing a new feature:

### Step 1 — Identify the module

Example:

```text
Attendance
```

Create:

```text
src/modules/attendance/
```

### Step 2 — Create required NestJS components

Only create what is needed:

```text
attendance/
├── dto/
├── attendance.controller.ts
├── attendance.service.ts
├── attendance.module.ts
├── attendance.repository.ts
├── attendance.constant.ts
└── attendance.types.ts
```

### Step 3 — Keep responsibilities separated

```text
Controller → Service → Repository
```

### Step 4 — Extract reusable infrastructure

If the feature introduces something reusable across multiple modules, move it to:

```text
src/common/
```

### Step 5 — Handle configuration properly

Environment-dependent values:

```text
src/config/
```

Static values:

```text
src/constants/
```

---

# 54. Agent Rules for Modifying Existing Code

Before modifying existing code:

1. Inspect the existing module structure.
2. Reuse existing services/utilities/constants.
3. Follow existing naming conventions.
4. Do not introduce a second pattern for the same problem.
5. Avoid unnecessary refactoring.
6. Preserve backward compatibility unless the task explicitly requires breaking changes.
7. Do not move files unnecessarily.
8. Do not change unrelated code.

The smallest correct change is preferred.

---

# 55. Agent Rules for Refactoring

When refactoring:

* Preserve behavior unless explicitly asked otherwise.
* Avoid mixing refactoring with unrelated feature work.
* Remove duplicated logic where practical.
* Extract reusable logic only when there is a real reuse case.
* Keep modules independently understandable.
* Do not create generic abstractions prematurely.

Avoid over-engineering.

---

# 56. Recommended Final Structure

A mature application may look like:

```text
src/
│
├── common/
│   ├── decorators/
│   ├── exceptions/
│   ├── filters/
│   ├── guards/
│   ├── interceptors/
│   ├── middleware/
│   ├── pipes/
│   ├── strategies/
│   ├── types/
│   └── utils/
│
├── config/
│   ├── app.config.ts
│   ├── auth.config.ts
│   ├── database.config.ts
│   ├── mail.config.ts
│   └── index.ts
│
├── constants/
│   ├── app.constant.ts
│   ├── pagination.constant.ts
│   ├── response.constant.ts
│   └── index.ts
│
├── database/
│   ├── migrations/
│   ├── seeders/
│   ├── database.module.ts
│   └── database.service.ts
│
├── modules/
│   │
│   ├── auth/
│   │   ├── dto/
│   │   ├── guards/
│   │   ├── strategies/
│   │   ├── auth.controller.ts
│   │   ├── auth.service.ts
│   │   ├── auth.module.ts
│   │   ├── auth.constant.ts
│   │   └── auth.types.ts
│   │
│   ├── users/
│   │   ├── dto/
│   │   ├── entities/
│   │   ├── users.controller.ts
│   │   ├── users.service.ts
│   │   ├── users.repository.ts
│   │   ├── users.module.ts
│   │   ├── users.constant.ts
│   │   └── users.types.ts
│   │
│   └── notifications/
│       ├── dto/
│       ├── providers/
│       ├── jobs/
│       ├── notifications.controller.ts
│       ├── notifications.service.ts
│       └── notifications.module.ts
│
├── app.module.ts
└── main.ts
```

---

# 57. Golden Rules for Agents

The following rules are mandatory:

1. **All business modules go inside `src/modules/`.**
2. **Shared cross-cutting functionality goes inside `src/common/`.**
3. **Environment-dependent values go inside `src/config/`.**
4. **Static shared values go inside `src/constants/`.**
5. **Module-specific constants stay inside the module.**
6. **Never hardcode secrets.**
7. **Avoid direct `process.env` access outside configuration.**
8. **Controllers must remain thin.**
9. **Business logic belongs in services.**
10. **Database access belongs in repositories/data-access layers.**
11. **Do not put business logic inside `common/`.**
12. **Do not use `utils/` as a dumping ground.**
13. **Reuse existing code before creating new abstractions.**
14. **Avoid circular dependencies.**
15. **Use dependency injection instead of manual instantiation.**
16. **Validate external input using DTOs and validation pipes.**
17. **Avoid magic numbers and magic strings.**
18. **Use constants for static values and config for environment-dependent values.**
19. **Do not create unnecessary files or directories.**
20. **Do not introduce a new architectural pattern when an existing project pattern already exists.**
21. **Keep changes scoped to the requested feature.**
22. **Prefer simple, maintainable solutions over premature abstractions.**
23. **Follow the existing project's ORM and database conventions.**
24. **Do not duplicate business logic across controllers/services.**
25. **Every new file must have a clear architectural owner.**

---

# 58. Decision Tree for Agents

Before creating code, use this decision tree:

```text
                    New Code
                       │
                       ▼
             Is it business logic?
                  /          \
                YES           NO
                 │             │
                 ▼             ▼
           Which module?   Is it reusable?
                 │          /          \
                 ▼        YES          NO
          modules/<x>/      │            │
                            ▼            ▼
                         common/     Keep close to
                                    its owner
```

For values:

```text
                  New Value
                     │
                     ▼
          Does it change by environment?
                 /             \
               YES              NO
                │                │
                ▼                ▼
             config/         constants/
```

For request handling:

```text
HTTP Request
     │
     ▼
Middleware
     │
     ▼
Guard
     │
     ▼
Interceptor
     │
     ▼
Pipe / DTO Validation
     │
     ▼
Controller
     │
     ▼
Service
     │
     ▼
Repository
     │
     ▼
Database
```

---

# 59. Definition of Done

Before considering a backend change complete, verify:

* [ ] Code is inside the correct module.
* [ ] Controller contains no unnecessary business logic.
* [ ] Business logic is inside services.
* [ ] Database access is properly separated.
* [ ] DTO validation is implemented where required.
* [ ] Constants are not hardcoded.
* [ ] Environment-specific values use configuration.
* [ ] Secrets are not committed.
* [ ] Shared logic is placed in `common/` only when genuinely reusable.
* [ ] No unnecessary files were created.
* [ ] No unnecessary abstractions were introduced.
* [ ] Existing patterns were reused.
* [ ] Imports follow project conventions.
* [ ] Error handling is appropriate.
* [ ] Tests are added/updated where appropriate.
* [ ] Linting and formatting pass.
