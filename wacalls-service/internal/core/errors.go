package core

import "errors"

var (
	ErrVoipUnsupported     = errors.New("provider does not support WhatsApp VoIP calling")
	ErrSessionNotPaired     = errors.New("session is not authenticated or paired")
	ErrSessionAlreadyPaired = errors.New("session is already paired")
	ErrMaxConcurrentCalls   = errors.New("maximum concurrent calls reached for this session")
	ErrNotFound             = errors.New("resource not found")
	ErrUnauthorized         = errors.New("unauthorized: invalid API key or tenant credentials")
	ErrOperatorBusy         = errors.New("operator is already on an active call")
	ErrCallClaimed          = errors.New("call has already been claimed by another operator")
	ErrCallNotFound         = errors.New("call not found")
	ErrCallNotInState       = errors.New("call is not in an acceptable state")
	ErrInvalidRequest       = errors.New("invalid request parameters")
)

