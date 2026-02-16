import '/flutter_flow/flutter_flow_util.dart';
import '/index.dart';
import 'onboarding_widget.dart' show OnboardingWidget;
import 'package:flutter/material.dart';

class OnboardingModel extends FlutterFlowModel<OnboardingWidget> {
  ///  State fields for stateful widgets in this page.

  // State field(s) for OnboardingPageView widget.
  PageController? onboardingPageViewController;

  int get onboardingPageViewCurrentIndex =>
      onboardingPageViewController != null &&
              onboardingPageViewController!.hasClients &&
              onboardingPageViewController!.page != null
          ? onboardingPageViewController!.page!.round()
          : 0;

  @override
  void initState(BuildContext context) {}

  @override
  void dispose() {}
}
