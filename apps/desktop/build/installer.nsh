; The state file is copied by the new package. It prevents a policy-less
; replacement from inheriting predecessor trust after its payload is installed.
!macro customInstall
  StrCpy $1 "0"
  ClearErrors
  FileOpen $0 "$INSTDIR\resources\update-policy-state" r
  IfErrors policy_state_cleanup
  ClearErrors
  FileRead $0 $1 7
  IfErrors policy_state_close
  StrCmpS $1 "present" 0 policy_state_close
  ClearErrors
  FileReadByte $0 $2
  IfErrors policy_state_close
  IntCmp $2 10 policy_state_eof policy_state_close policy_state_close
  policy_state_eof:
  ClearErrors
  FileReadByte $0 $2
  IfErrors policy_state_present policy_state_close
  policy_state_present:
  StrCpy $1 "1"
  policy_state_close:
  ClearErrors
  FileClose $0
  IfErrors policy_state_cleanup
  StrCmp $1 "1" policy_state_remove_state policy_state_cleanup
  policy_state_cleanup:
  ClearErrors
  Delete "$INSTDIR\resources\update-policy.json"
  IfErrors policy_state_abort
  policy_state_remove_state:
  ClearErrors
  Delete "$INSTDIR\resources\update-policy-state"
  IfErrors policy_state_abort
  Goto policy_state_done
  policy_state_abort:
  Abort "Harness Desktop update policy state could not be retired"
  policy_state_done:
!macroend
