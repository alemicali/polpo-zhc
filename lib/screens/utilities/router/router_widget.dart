import '/auth/firebase_auth/auth_util.dart';
import '/backend/backend.dart';
import '/flutter_flow/flutter_flow_theme.dart';
import '/flutter_flow/flutter_flow_util.dart';
import '/index.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:provider/provider.dart';
import 'router_model.dart';
export 'router_model.dart';

class RouterWidget extends StatefulWidget {
  const RouterWidget({super.key});

  static String routeName = 'Router';
  static String routePath = '/router';

  @override
  State<RouterWidget> createState() => _RouterWidgetState();
}

class _RouterWidgetState extends State<RouterWidget> {
  late RouterModel _model;

  final scaffoldKey = GlobalKey<ScaffoldState>();

  @override
  void initState() {
    super.initState();
    _model = createModel(context, () => RouterModel());

    // On page load action.
    SchedulerBinding.instance.addPostFrameCallback((_) async {
      if (!FFAppState().firstLogin) {
        // Go to Onboarding Screen

        context.goNamed(
          OnboardingWidget.routeName,
          extra: <String, dynamic>{
            kTransitionInfoKey: TransitionInfo(
              hasTransition: true,
              transitionType: PageTransitionType.fade,
              duration: Duration(milliseconds: 0),
            ),
          },
        );

        // Set firstLogin to true
        FFAppState().firstLogin = true;
      } else {
        if (valueOrDefault(currentUserDocument?.role, '') == 'worker') {
          _model.accomodations = await queryAccomodationWorkersRecordOnce(
            queryBuilder: (accomodationWorkersRecord) =>
                accomodationWorkersRecord
                    .where(
                      'worker',
                      isEqualTo: currentUserDocument?.worker,
                    )
                    .where(
                      'endDate',
                      isGreaterThan: getCurrentTimestamp,
                    )
                    .where(
                      'active',
                      isEqualTo: true,
                    ),
          );
          if (_model.accomodations!.length > 0) {
            if ((FFAppState().selectedAccomodation != null) &&
                (FFAppState().selectedAccomodation.hasAccomodation() == true)) {
              _model.accommodationData =
                  await AccomodationWorkersRecord.getDocumentOnce(
                      FFAppState().selectedAccomodation.ref!);
              if (!((_model.accommodationData!.endDate! >
                      getCurrentTimestamp) &&
                  (_model.accommodationData?.active == true))) {
                // Accommodation is expired, force selection
                context.goNamed(AccomodationsWidget.routeName);
                return;
              } else {
                // Accommodation is valid, go to Home
                context.goNamed(HomeWidget.routeName);
              }
            } else {
              // No accommodation selected, force selection
              context.goNamed(AccomodationsWidget.routeName);
              return;
            }
          } else {
            context.pushNamed(HelpWidget.routeName);
          }
        } else {
          context.pushNamed(HelpWidget.routeName);
        }
      }
    });

    WidgetsBinding.instance.addPostFrameCallback((_) => safeSetState(() {}));
  }

  @override
  void dispose() {
    _model.dispose();

    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    context.watch<FFAppState>();

    return Title(
        title: 'Router',
        color: FlutterFlowTheme.of(context).primary.withAlpha(0XFF),
        child: GestureDetector(
          onTap: () {
            FocusScope.of(context).unfocus();
            FocusManager.instance.primaryFocus?.unfocus();
          },
          child: Scaffold(
            key: scaffoldKey,
            backgroundColor: FlutterFlowTheme.of(context).secondaryBackground,
            body: SafeArea(
              top: true,
              child: Container(
                width: MediaQuery.sizeOf(context).width * 1.0,
                height: MediaQuery.sizeOf(context).height * 1.0,
                decoration: BoxDecoration(
                  color: FlutterFlowTheme.of(context).secondaryBackground,
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.max,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    ClipRRect(
                      borderRadius: BorderRadius.circular(8.0),
                      child: Image.asset(
                        'assets/images/BFWellnesApp_v2.png',
                        width: 300.0,
                        height: 200.0,
                        fit: BoxFit.contain,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ));
  }
}
