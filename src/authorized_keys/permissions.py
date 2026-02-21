"""
Custom permission classes for internal API endpoints.

These permissions are designed for service-to-service communication
within the Docker network, using shared-secret token authentication.
"""

import os
import logging

from rest_framework.permissions import BasePermission

logger = logging.getLogger('authorized_keys.internal')

# Shared secret token for internal API calls (set via INTERNAL_API_TOKEN env var)
INTERNAL_API_TOKEN = os.environ.get('INTERNAL_API_TOKEN', '')


class IsInternalService(BasePermission):
    """Allow access only if the request carries a valid internal API token.

    The token must be sent in the ``Authorization`` header as:
        Authorization: Bearer <token>

    The expected token is read from the ``INTERNAL_API_TOKEN`` environment
    variable.  If the variable is not set or empty, **all requests are
    denied** to prevent accidental open access.
    """

    def has_permission(self, request, view):
        if not INTERNAL_API_TOKEN:
            logger.error(
                "INTERNAL_API_TOKEN env var is not set — denying all internal API requests"
            )
            return False

        auth_header = request.META.get('HTTP_AUTHORIZATION', '')

        if not auth_header.startswith('Bearer '):
            logger.warning(
                "Internal API request missing Bearer token | IP=%s",
                request.META.get('REMOTE_ADDR', 'unknown'),
            )
            return False

        token = auth_header[7:]  # Strip "Bearer "

        if token != INTERNAL_API_TOKEN:
            logger.warning(
                "Internal API request with invalid token | IP=%s",
                request.META.get('REMOTE_ADDR', 'unknown'),
            )
            return False

        return True
