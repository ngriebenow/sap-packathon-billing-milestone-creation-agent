using { sap } from '@sap/cds/common';

@path: '/api'
service AgentService {

  /**
   * Handles all chat turns after the initial document upload.
   * The initial upload is handled by a custom Express route /api/upload.
   */
  action chat(
    sessionId : String,
    message   : String
  ) returns {
    sessionId  : String;
    reply      : String;
    milestones : array of {
      milestoneNumber : Integer;
      billingDate     : String;
      amount          : Decimal(16,2);
      percentage      : Decimal(5,2);
      currency        : String;
      description     : String;
    };
    status     : String;
  };

  /**
   * Triggers creation of confirmed milestones in SAP S/4HANA.
   * Called after the user reviews and confirms the milestone table.
   */
  action createInSAP(
    sessionId : String
  ) returns {
    success    : Boolean;
    message    : String;
    created    : Integer;
    billingPlan: String;
  };

  /**
   * Predicts payment delay risk for each milestone in the current session
   * using historical billing plans with similar contract values as context.
   */
  action predictDelayRisk(
    sessionId : String
  ) returns {
    sessionId : String;
    risks     : array of {
      milestoneNumber : Integer;
      description     : String;
      riskLevel       : String;
      reasoning       : String;
    };
    summary   : String;
  };

  /**
   * Suggests an optimized billing plan structure based on historical data
   * and cash flow best practices. Total contract value is preserved.
   */
  action suggestOptimization(
    sessionId : String
  ) returns {
    sessionId   : String;
    suggestion  : array of {
      milestoneNumber : Integer;
      suggestedDate   : String;
      suggestedAmount : Decimal(16,2);
      percentage      : Decimal(5,2);
      description     : String;
      changeReason    : String;
    };
    explanation       : String;
    financialSavings  : {
      amount    : Decimal(16,2);
      currency  : String;
      reasoning : String;
    };
  };
  /**
   * Silently updates a single editable field on a milestone in the session.
   * Called from the inline table editor — no AI round-trip.
   */
  action updateMilestone(
    sessionId       : String,
    milestoneNumber : Integer,
    field           : String,
    value           : String
  ) returns {
    success         : Boolean;
    milestoneNumber : Integer;
    field           : String;
    newValue        : String;
  };
}
