from django.contrib.auth import login
from django.core.exceptions import ValidationError

from rest_framework.response import Response
from rest_framework.exceptions import ValidationError as DRFValidationError

from custom_auth.exception import InvalidEmailError
from custom_auth.utils.get_tokens_for_user import get_tokens_for_user

import logging
logger = logging.getLogger(__name__)

def third_party_login(serializer, request, session=False):
    # 先做輸入驗證；失敗時記錄欄位錯誤（例如缺少 / 空白的 credential）再交由 DRF 回應 400
    # Validate input first; on failure log the field errors (e.g. missing/blank credential)
    # before letting DRF return its standard 400 response.
    try:
        serializer.is_valid(raise_exception=True)
    except DRFValidationError:
        logger.warning(f"[AUTH][3RD] Serializer validation failed: {serializer.errors}")
        raise

    try:
        user = serializer.save()
        if session:
            login(request=request, user=user)
        logger.info(f"[AUTH][3RD] Login success for user `{user.username}` (session={session})")
        return Response(get_tokens_for_user(user))
    except InvalidEmailError:
        # 非允許網域的信箱，預期內的拒絕，不需要 traceback
        # Disallowed email domain — an expected rejection, no traceback needed.
        logger.warning("[AUTH][3RD] Login rejected: email domain is not allowed")
        return Response({
                "status": "error",
                "detail": "This email is invalid."
            }, status=401
        )
    except ValueError as exception:
        # logger.exception 會一併記錄完整 traceback，方便定位失敗點
        # logger.exception records the full traceback so the failure point is visible.
        logger.exception(f"[AUTH][3RD] ValueError during third-party login: {exception}")
        return Response({
                "status": "error",
                "detail": "Something went wrong :("
            },status=500
        )
    except ValidationError as exception:
        logger.exception(f"[AUTH][3RD] ValidationError during third-party login: {exception}")
        return Response({
                "status": "error",
                "detail": "Disallowed creation of user now."
            }, status=400
        )
    except Exception as exception:
        logger.exception(
            f"[AUTH][3RD] Unexpected error during third-party login: "
            f"{type(exception).__name__}: {exception}"
        )
        return Response({
                "status": "error",
                "detail": "Unknown Error",
            }, status=500
        )
