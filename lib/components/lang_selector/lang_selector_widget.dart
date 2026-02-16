import '/flutter_flow/flutter_flow_language_selector.dart';
import '/flutter_flow/flutter_flow_theme.dart';
import '/flutter_flow/flutter_flow_util.dart';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'lang_selector_model.dart';
export 'lang_selector_model.dart';

class LangSelectorWidget extends StatefulWidget {
  const LangSelectorWidget({super.key});

  @override
  State<LangSelectorWidget> createState() => _LangSelectorWidgetState();
}

class _LangSelectorWidgetState extends State<LangSelectorWidget> {
  late LangSelectorModel _model;

  @override
  void setState(VoidCallback callback) {
    super.setState(callback);
    _model.onUpdate();
  }

  @override
  void initState() {
    super.initState();
    _model = createModel(context, () => LangSelectorModel());

    WidgetsBinding.instance.addPostFrameCallback((_) => safeSetState(() {}));
  }

  @override
  void dispose() {
    _model.maybeDispose();

    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsetsDirectional.fromSTEB(0.0, 0.0, 0.0, 50.0),
      child: FlutterFlowLanguageSelector(
        width: 140.0,
        backgroundColor: FlutterFlowTheme.of(context).homeBackground,
        borderColor: Colors.transparent,
        dropdownIconColor: FlutterFlowTheme.of(context).secondaryText,
        borderRadius: 8.0,
        textStyle: FlutterFlowTheme.of(context).labelLarge.override(
              font: GoogleFonts.dmSans(
                fontWeight: FlutterFlowTheme.of(context).labelLarge.fontWeight,
                fontStyle: FlutterFlowTheme.of(context).labelLarge.fontStyle,
              ),
              letterSpacing: 0.0,
              fontWeight: FlutterFlowTheme.of(context).labelLarge.fontWeight,
              fontStyle: FlutterFlowTheme.of(context).labelLarge.fontStyle,
            ),
        hideFlags: false,
        flagSize: 24.0,
        flagTextGap: 8.0,
        currentLanguage: FFLocalizations.of(context).languageCode,
        languages: FFLocalizations.languages(),
        onChanged: (lang) => setAppLanguage(context, lang),
      ),
    );
  }
}
