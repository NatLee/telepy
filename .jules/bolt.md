## 2024-05-23 - N+1 Queries in Serializer Method Fields
**Learning:** SerializerMethodFields that call helper methods performing DB queries are a major source of N+1 issues, even if the main queryset is optimized.
**Action:** Always check what helper methods in serializers are doing. Use `prefetch_related` with `to_attr` to pass context-specific related objects (like "current user's permissions") to the model instance, and update helpers to use them.
